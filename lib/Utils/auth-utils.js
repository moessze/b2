import NodeCache from '@cacheable/node-cache';
import { Boom } from '@hapi/boom';
import { AsyncLocalStorage } from 'async_hooks';
import { Mutex } from 'async-mutex';
import { randomBytes } from 'crypto';
import { DEFAULT_CACHE_TTLS } from '../Defaults/index.js';
import { Curve, signedKeyPair } from './crypto.js';
import { delay, generateRegistrationId } from './generics.js';
import { PreKeyManager } from './pre-key-manager.js';
// One instance per process: a per-socket AsyncLocalStorage leaks the heap under Node's legacy
// async-context propagation, where every live instance tags every pending async resource. The
// value is keyed by store token so a store only ever sees its own context, even when another
// wrapped store runs inside its transaction.
const txStorage = new AsyncLocalStorage();
/**
 * Adds caching capability to a SignalKeyStore
 * @param store the store to add caching to
 * @param logger to log trace events
 * @param _cache cache store to use
 */
export function makeCacheableSignalKeyStore(store, logger, _cache) {
    const cache = _cache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.SIGNAL_STORE, // 5 minutes
            useClones: false,
            deleteOnExpire: true
        });
    // Mutex for protecting cache operations
    const cacheMutex = new Mutex();
    function getUniqueId(type, id) {
        return `${type}.${id}`;
    }
    return {
        async get(type, ids) {
            return cacheMutex.runExclusive(async () => {
                const data = {};
                const idsToFetch = [];
                for (const id of ids) {
                    const item = (await cache.get(getUniqueId(type, id)));
                    if (typeof item !== 'undefined') {
                        data[id] = item;
                    }
                    else {
                        idsToFetch.push(id);
                    }
                }
                if (idsToFetch.length) {
                    logger?.trace({ items: idsToFetch.length }, 'loading from store');
                    const fetched = await store.get(type, idsToFetch);
                    for (const id of idsToFetch) {
                        const item = fetched[id];
                        if (item) {
                            data[id] = item;
                            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                            await cache.set(getUniqueId(type, id), item);
                        }
                    }
                }
                return data;
            });
        },
        async set(data) {
            return cacheMutex.runExclusive(async () => {
                let keys = 0;
                for (const type in data) {
                    for (const id in data[type]) {
                        await cache.set(getUniqueId(type, id), data[type][id]);
                        keys += 1;
                    }
                }
                logger?.trace({ keys }, 'updated cache');
                await store.set(data);
            });
        },
        async clear() {
            await cache.flushAll();
            await store.clear?.();
        }
    };
}
/**
 * Adds DB-like transaction capability to the SignalKeyStore
 * Uses AsyncLocalStorage for automatic context management
 * @param state the key store to apply this capability to
 * @param logger logger to log events
 * @returns SignalKeyStore with transaction capability
 */
export const addTransactionCapability = (state, logger, { maxCommitRetries, delayBetweenTriesMs }) => {
    // Transaction mutexes with reference counting for cleanup
    const txMutexes = new Map();
    const txMutexRefCounts = new Map();
    // Pre-key manager for specialized operations
    const preKeyManager = new PreKeyManager(state, logger);
    // Debounced writer: collects writes within a window and flushes as one SQLite tx
    const debounceWindow = 5000;
    let debounceTimer = null;
    let debouncedData = {};
    // One writer at a time. A debounced flush and a transaction commit both call state.set, and
    // interleaving them lets an older debounced value land on top of a newer committed one.
    const writeMutex = new Mutex();
    const flushDebounced = async () => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        const data = debouncedData;
        debouncedData = {};
        if (Object.keys(data).length === 0) return;
        // All types in one call: that is the single SQLite transaction this debounce exists for.
        await writeMutex.runExclusive(() => state.set(data));
    };
    const scheduleFlush = () => {
        // Max age, not a sliding window: re-arming the timer on every write meant a socket that
        // never went quiet for a full window never flushed at all, leaving ratchet state in memory
        // only until the process happened to die.
        if (debounceTimer) return;
        debounceTimer = setTimeout(() => {
            // The timer has nowhere to report to, and an unhandled rejection here takes down the
            // whole process - every other session in it included.
            flushDebounced().catch(err => logger.error({ err }, 'failed to flush signal keys'));
        }, debounceWindow);
    };
    /**
     * Get or create a transaction mutex
     */
    function getTxMutex(key) {
        if (!txMutexes.has(key)) {
            txMutexes.set(key, new Mutex());
            txMutexRefCounts.set(key, 0);
        }
        return txMutexes.get(key);
    }
    /**
     * Acquire a reference to a transaction mutex
     */
    function acquireTxMutexRef(key) {
        const count = txMutexRefCounts.get(key) ?? 0;
        txMutexRefCounts.set(key, count + 1);
    }
    /**
     * Release a reference to a transaction mutex and cleanup if no longer needed
     */
    function releaseTxMutexRef(key) {
        const count = (txMutexRefCounts.get(key) ?? 1) - 1;
        txMutexRefCounts.set(key, count);
        // Cleanup if no more references and mutex is not locked
        if (count <= 0) {
            const mutex = txMutexes.get(key);
            if (mutex && !mutex.isLocked()) {
                txMutexes.delete(key);
                txMutexRefCounts.delete(key);
            }
        }
    }
    /**
     * Check if currently in a transaction
     */
    function isInTransaction() {
        return !!txStorage.getStore();
    }
    /**
     * Commit transaction with retries
     */
    async function commitWithRetry(mutations) {
        if (Object.keys(mutations).length === 0) {
            logger.trace('no mutations in transaction');
            return;
        }
        logger.trace('committing transaction');
        // Whatever is still debounced was written BEFORE these mutations, so it has to land first
        // or it overwrites them.
        await flushDebounced();
        for (let attempt = 0; attempt < maxCommitRetries; attempt++) {
            try {
                await writeMutex.runExclusive(() => state.set(mutations));
                logger.trace({ mutationCount: Object.keys(mutations).length }, 'committed transaction');
                return;
            }
            catch (error) {
                const retriesLeft = maxCommitRetries - attempt - 1;
                logger.warn(`failed to commit mutations, retries left=${retriesLeft}`);
                if (retriesLeft === 0) {
                    throw error;
                }
                await delay(delayBetweenTriesMs);
            }
        }
    }
    return {
        get: async (type, ids) => {
            const ctx = txStorage.getStore();
            if (!ctx) {
                // No transaction - direct read without exclusive lock for concurrency
                return state.get(type, ids);
            }
            // In transaction - check cache first
            const cached = ctx.cache[type] || {};
            const missing = ids.filter(id => !(id in cached));
            if (missing.length > 0) {
                ctx.dbQueries++;
                logger.trace({ type, count: missing.length }, 'fetching missing keys in transaction');
                const fetched = await getTxMutex(type).runExclusive(() => state.get(type, missing));
                // Update cache
                ctx.cache[type] = ctx.cache[type] || {};
                Object.assign(ctx.cache[type], fetched);
            }
            // Return requested ids from cache
            const result = {};
            for (const id of ids) {
                const value = ctx.cache[type]?.[id];
                if (value !== undefined && value !== null) {
                    result[id] = value;
                }
            }
            return result;
        },
        set: async (data) => {
            const ctx = txStorage.getStore();
            if (!ctx) {
                // No transaction - debounce writes to batch into fewer SQLite transactions
                for (const type_ in data) {
                    const type = type_;
                    if (type === 'pre-key') {
                        await preKeyManager.validateDeletions(data, type);
                    }
                    debouncedData[type] = { ...debouncedData[type], ...data[type] };
                }
                scheduleFlush();
                return;
            }
            // In transaction - update cache and mutations
            logger.trace({ types: Object.keys(data) }, 'caching in transaction');
            for (const key_ in data) {
                const key = key_;
                // Ensure structures exist
                ctx.cache[key] = ctx.cache[key] || {};
                ctx.mutations[key] = ctx.mutations[key] || {};
                // Special handling for pre-keys
                if (key === 'pre-key') {
                    await preKeyManager.processOperations(data, key, ctx.cache, ctx.mutations, true);
                }
                else {
                    // Normal key types
                    Object.assign(ctx.cache[key], data[key]);
                    Object.assign(ctx.mutations[key], data[key]);
                }
            }
        },
        isInTransaction,
        transaction: async (work, key) => {
            const existing = txStorage.getStore();
            // Nested transaction - reuse existing context
            if (existing) {
                logger.trace('reusing existing transaction context');
                return work();
            }
            // New transaction - acquire mutex and create context
            const mutex = getTxMutex(key);
            acquireTxMutexRef(key);
            try {
                return await mutex.runExclusive(async () => {
                    const ctx = {
                        cache: {},
                        mutations: {},
                        dbQueries: 0
                    };
                    logger.trace('entering transaction');
                    try {
                        const result = await txStorage.run(ctx, work);
                        // Commit mutations
                        await commitWithRetry(ctx.mutations);
                        logger.trace({ dbQueries: ctx.dbQueries }, 'transaction completed');
                        return result;
                    }
                    catch (error) {
                        logger.error({ error }, 'transaction failed, rolling back');
                        throw error;
                    }
                });
            }
            finally {
                releaseTxMutexRef(key);
            }
        },
        flush: flushDebounced
    };
};
/**
 * Returns the authenticated user's JID, or throws a Boom-401 if creds are not yet authenticated.
 * Use this anywhere we'd otherwise reach for `creds.me!.id` to fail fast with a descriptive error.
 */
export const assertMeId = (creds) => {
    const id = creds.me?.id;
    if (!id) {
        throw new Boom('Cannot proceed: socket is not authenticated yet (creds.me.id is missing)', { statusCode: 401 });
    }
    return id;
};
export const initAuthCreds = () => {
    const identityKey = Curve.generateKeyPair();
    return {
        noiseKey: Curve.generateKeyPair(),
        pairingEphemeralKeyPair: Curve.generateKeyPair(),
        signedIdentityKey: identityKey,
        signedPreKey: signedKeyPair(identityKey, 1),
        registrationId: generateRegistrationId(),
        advSecretKey: randomBytes(32).toString('base64'),
        processedHistoryMessages: [],
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        accountSyncCounter: 0,
        accountSettings: {
            unarchiveChats: false
        },
        registered: false,
        pairingCode: undefined,
        lastPropHash: undefined,
        routingInfo: undefined,
        additionalData: undefined
    };
};
//# sourceMappingURL=auth-utils.js.map