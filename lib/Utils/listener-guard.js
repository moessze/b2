/**
 * EventEmitter discards whatever a listener returns. An async listener that rejects therefore
 * becomes an unhandled rejection, and Node's default for those is to terminate the process.
 *
 * In a host that runs one socket per account that is the difference between one account having a
 * bad minute and every account in the process being disconnected at once: a single stanza that
 * arrives while its own connection is closing takes the whole fleet down. Wrapping a listener keeps
 * the failure where it happened.
 *
 * Wrappers are remembered per original function so `off(event, handler)` still finds the
 * registration made by `on(event, handler)` - without that, every listener would leak.
 *
 * Deliberately importless: this is used from the transport client and from the event buffer, and a
 * cycle through Utils/index.js would be easy to introduce and annoying to find.
 */
export const makeListenerGuard = (onError) => {
   const wrappers = new WeakMap()
   return {
      /** the function to hand to EventEmitter in place of `listener` */
      wrap (listener) {
         if (typeof listener !== 'function') return listener
         const existing = wrappers.get(listener)
         if (existing) return existing
         const wrapper = function (...args) {
            let result
            try {
               result = listener.apply(this, args)
            }
            catch (err) {
               onError(err)
               return
            }
            // Only promises need the catch; a sync listener already returned normally.
            if (result && typeof result.catch === 'function') result.catch(onError)
            return result
         }
         wrappers.set(listener, wrapper)
         return wrapper
      },
      /** the registration made for `listener`, so removal works on the original reference */
      unwrap (listener) {
         if (typeof listener !== 'function') return listener
         return wrappers.get(listener) || listener
      }
   }
}
