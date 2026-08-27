import { EventEmitter } from 'events';
import { URL } from 'url';
import { makeListenerGuard } from '../../Utils/listener-guard.js';
export class AbstractSocketClient extends EventEmitter {
    constructor(url, config) {
        super();
        this.url = url;
        this.config = config;
        this.setMaxListeners(0);
        // Every stanza handler in this library is registered here as an async listener, and a
        // rejection from one of those is an unhandled rejection - which Node answers by killing the
        // process, disconnecting every other account it hosts. Guarding registration rather than
        // each of the ~12 call sites means a handler added later cannot reintroduce it.
        this.listenerGuard = makeListenerGuard(err => {
            const logger = this.config?.logger;
            if (logger?.error)
                logger.error({ err, url: this.url?.toString?.() }, 'unhandled error in socket listener');
            else
                console.error('unhandled error in socket listener', err);
        });
    }
    on(event, listener) {
        return super.on(event, this.listenerGuard.wrap(listener));
    }
    addListener(event, listener) {
        return this.on(event, listener);
    }
    once(event, listener) {
        return super.once(event, this.listenerGuard.wrap(listener));
    }
    prependListener(event, listener) {
        return super.prependListener(event, this.listenerGuard.wrap(listener));
    }
    prependOnceListener(event, listener) {
        return super.prependOnceListener(event, this.listenerGuard.wrap(listener));
    }
    off(event, listener) {
        return super.off(event, this.listenerGuard.unwrap(listener));
    }
    removeListener(event, listener) {
        return super.removeListener(event, this.listenerGuard.unwrap(listener));
    }
}
//# sourceMappingURL=types.js.map
