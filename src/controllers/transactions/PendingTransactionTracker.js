import EventEmitter from '@metamask/safe-event-emitter'
import EthQuery from 'ethjs-query'
import log from 'loglevel'

/**

  Event emitter utility class for tracking the transactions as they<br>
  go from a pending state to a confirmed (mined in a block) state<br>
<br>
  As well as continues broadcast while in the pending state
<br>
@param config {object} - non optional configuration object consists of:
    @param {Object} config.provider - A network provider.
    @param {Object} config.nonceTracker see nonce tracker
    @param {function} config.getPendingTransactions a function for getting an array of transactions,
    @param {function} config.publishTransaction a async function for publishing raw transactions,

@class
*/

class PendingTransactionTracker extends EventEmitter {
  DROPPED_BUFFER_COUNT = 3

  droppedBlocksBufferByHash = new Map()

  constructor(config) {
    super()
    this.droppedBuffer = {}
    this.query = config.query || new EthQuery(config.provider)
    this.nonceTracker = config.nonceTracker
    this.getPendingTransactions = config.getPendingTransactions
    this.getCompletedTransactions = config.getCompletedTransactions
    this.publishTransaction = config.publishTransaction
    this.approveTransaction = config.approveTransaction
    this.confirmTransaction = config.confirmTransaction
  }

  /**
    checks the network for signed txs and releases the nonce global lock if it is
  */
  async updatePendingTxs() {
    // in order to keep the nonceTracker accurate we block it while updating pending transactions
    const nonceGlobalLock = await this.nonceTracker.getGlobalLock()
    try {
      const pendingTxs = this.getPendingTransactions()
      await Promise.all(pendingTxs.map((txMeta) => this._checkPendingTx(txMeta)))
    } catch (error) {
      log.error('PendingTransactionTracker - Error updating pending transactions')
      log.error(error)
    }
    nonceGlobalLock.releaseLock()
  }

  /**
    Will resubmit any transactions who have not been confirmed in a block
    @param block {object} - a block object
    @emits tx:warning
  */
  resubmitPendingTxs(blockNumber) {
    const pending = this.getPendingTransactions()
    // only try resubmitting if their are transactions to resubmit
    if (pending.length === 0) return
    pending.forEach((txMeta) => {
      this._resubmitTx(txMeta, blockNumber).catch((error) => {
        /*
      Dont marked as failed if the error is a "known" transaction warning
      "there is already a transaction with the same sender-nonce
      but higher/same gas price"

      Also don't mark as failed if it has ever been broadcast successfully.
      A successful broadcast means it may still be mined.
      */
        const errorMessage = error.value?.message?.toLowerCase() || error.message.toLowerCase()
        const isKnownTx =
          // geth
          errorMessage.includes('replacement transaction underpriced') ||
          errorMessage.includes('known transaction') ||
          // parity
          errorMessage.includes('gas price too low to replace') ||
          errorMessage.includes('transaction with the same hash was already imported') ||
          // other
          errorMessage.includes('gateway timeout') ||
          errorMessage.includes('nonce too low')
        // ignore resubmit warnings, return early
        if (isKnownTx) return
        // encountered real error - transition to error state
        txMeta.warning = {
          error: errorMessage,
          message: 'There was an error when resubmitting this transaction.',
        }
        this.emit('tx:warning', txMeta, error)
      })
    })
  }

  /**
    resubmits the individual txMeta used in resubmitPendingTxs
    @param txMeta {Object} - txMeta object
    @param latestBlockNumber {string} - hex string for the latest block number
    @emits tx:retry
    @returns txHash {string}
  */
  async _resubmitTx(txMeta, latestBlockNumber) {
    if (!txMeta.firstRetryBlockNumber) {
      this.emit('tx:block-update', txMeta, latestBlockNumber)
    }

    const firstRetryBlockNumber = txMeta.firstRetryBlockNumber || latestBlockNumber
    const txBlockDistance = Number.parseInt(latestBlockNumber, 16) - Number.parseInt(firstRetryBlockNumber, 16)

    const retryCount = txMeta.retryCount || 0

    // Exponential backoff to limit retries at publishing
    if (txBlockDistance <= 2 ** retryCount - 1) return undefined

    // Only auto-submit already-signed txs:
    if (!('rawTx' in txMeta)) return this.approveTransaction(txMeta.id)

    const { rawTx } = txMeta
    const txHash = await this.publishTransaction(rawTx)

    // Increment successful tries:
    this.emit('tx:retry', txMeta)
    return txHash
  }

  /**
    Ask the network for the transaction to see if it has been include in a block
    @param txMeta {Object} - the txMeta object
    @emits tx:failed
    @emits tx:confirmed
    @emits tx:warning
  */
  async _checkPendingTx(txMeta) {
    const txHash = txMeta.hash
    const txId = txMeta.id

    // Only check submitted txs
    if (txMeta.status !== 'submitted') return

    // extra check in case there was an uncaught error during the
    // signature and submission process
    if (!txHash) {
      const noTxHashError = new Error('We had an error while submitting this transaction, please try again.')
      noTxHashError.name = 'NoTxHashError'
      this.emit('tx:failed', txId, noTxHashError)
      return
    }

    // If another tx with the same nonce is mined, set as failed.
    if (this._checkIfNonceIsTaken(txMeta)) {
      this.emit('tx:dropped', txId)
      return
    }

    try {
      const transactionReceipt = await this.query.getTransactionReceipt(txHash)
      if (transactionReceipt?.blockNumber) {
        const { baseFeePerGas } = await this.query.getBlockByHash(transactionReceipt?.blockHash, false)
        this.emit('tx:confirmed', txId, transactionReceipt, baseFeePerGas)
        return
      }
    } catch (error) {
      // eslint-disable-next-line require-atomic-updates
      txMeta.warning = {
        error: error.message,
        message: 'There was a problem loading this transaction.',
      }
      this.emit('tx:warning', txMeta, error)
      return
    }

    if (await this._checkIfTxWasDropped(txMeta)) {
      this.emit('tx:dropped', txId)
    }
  }

  /**
    checks to see if if the tx's nonce has been used by another transaction
    @param txMeta {Object} - txMeta object
    @emits tx:dropped
    @returns {boolean}
  */

  async _checkIfTxWasDropped(txMeta) {
    const {
      hash: txHash,
      txParams: { nonce, from },
    } = txMeta
    const networkNextNonce = await this.query.getTransactionCount(from)

    if (Number.parseInt(nonce, 16) >= networkNextNonce.toNumber()) {
      return false
    }

    if (!this.droppedBlocksBufferByHash.has(txHash)) {
      this.droppedBlocksBufferByHash.set(txHash, 0)
    }

    const currentBlockBuffer = this.droppedBlocksBufferByHash.get(txHash)

    if (currentBlockBuffer < this.DROPPED_BUFFER_COUNT) {
      this.droppedBlocksBufferByHash.set(txHash, currentBlockBuffer + 1)
      return false
    }

    this.droppedBlocksBufferByHash.delete(txHash)
    return true
  }

  /**
    checks to see if a confirmed txMeta has the same nonce
    @param txMeta {Object} - txMeta object
    @returns {boolean}
  */

  _checkIfNonceIsTaken(txMeta) {
    const address = txMeta.txParams.from
    const completed = this.getCompletedTransactions(address)
    return completed.some((otherMeta) => {
      if (otherMeta.id === txMeta.id) {
        return false
      }
      return otherMeta.txParams.nonce === txMeta.txParams.nonce
    })
  }
}

export default PendingTransactionTracker
