/**
 * @fileoverview Handlers for BunnyBus instrumentation
 */

const {
    tracer,
    moduleUtils,
    eventInterface,
    utils,
} = require('epsagon');
const traceContext = require('../trace_context.js');
const { EPSAGON_HEADER } = require('../http.js');

/**
 * acts as a middleware for `BunnyBus consumer messages
 * @param {object} config data of the bunnybus
 * @param {Function} callback the callback function
 * @param {string} queue queue
 * @param {string} topic topic
 * @returns {Array} args original handler arguments
 */
function bunnybusSubscriberMiddleware(config, callback, queue, topic, ...args) {
    let originalHandlerSyncErr;
    let runnerResult;
    try {
        // Initialize tracer and runner.
        tracer.restart();
        const { slsEvent: amqpEvent, startTime: amqpStartTime } =
        eventInterface.initializeEvent(
            'rabbitmq',
            args[1].headers.routeKey,
            'consume',
            'trigger'
        );

        const metadata = {
            host: config.hostname,
            vhost: config.vhost,
            'messaging.message_payload_size_bytes': JSON.stringify(args[0]).length,
        };
        if (args[1].headers[EPSAGON_HEADER]) {
            metadata[EPSAGON_HEADER] = args[1].headers[EPSAGON_HEADER].toString();
        }

        tracer.addEvent(amqpEvent);
        eventInterface.finalizeEvent(amqpEvent, amqpStartTime, null, metadata, {
            headers: args[1].headers,
            message: args[0],
        });

        const { label, setError } = tracer;
        // eslint-disable-next-line no-param-reassign
        args.push({
            label,
            setError,
        });
        const runnerName = callback && callback.name ? callback.name : `${topic}-consumer`;
        const { slsEvent: nodeEvent, startTime: nodeStartTime } = eventInterface.initializeEvent(
            'node_function', runnerName, 'execute', 'runner'
        );

        try {
            runnerResult = callback(...args);
        } catch (err) {
            originalHandlerSyncErr = err;
        }

        // Handle and finalize async user function.
        if (utils.isPromise(runnerResult)) {
            let originalHandlerAsyncError;
            runnerResult = runnerResult.catch((err) => {
                originalHandlerAsyncError = err;
                throw err;
            }).finally(() => {
                eventInterface.finalizeEvent(nodeEvent, nodeStartTime, originalHandlerAsyncError);
                tracer.sendTrace(() => {});
            });
        } else {
            // Finalize sync user function.
            eventInterface.finalizeEvent(nodeEvent, nodeStartTime, originalHandlerSyncErr);
            tracer.sendTrace(() => {});
        }
        tracer.addRunner(nodeEvent, runnerResult);
    } catch (err) {
        tracer.addException(err);
    }
    // Throwing error in case of sync user function.
    if (originalHandlerSyncErr) {
        throw originalHandlerSyncErr;
    }
    return runnerResult;
}

/**
 * Wraps the BunnyBus callback and channel consumer creation to wrap the run function
 * @param {Function} wrappedFunction The BunnyBus subscribe function
 * @returns {Function} The wrapped function
 */
function bunnybusConsumerWrapper(wrappedFunction) {
    traceContext.init();
    tracer.getTrace = traceContext.get;
    return function internalBunnybusConsumerWrapper(queue, handlers, options) {
        if (options.meta) {
            // Enabling tracing only if meta is enabled.
            const bunny = this;
            bunny.__EPSAGON_PATCH = {}; // eslint-disable-line no-underscore-dangle
            Object.keys(handlers).forEach((topic) => {
                const callback = handlers[topic];
                // eslint-disable-next-line no-underscore-dangle
                if (typeof handlers[topic] === 'function' && bunny.__EPSAGON_PATCH && !bunny.__EPSAGON_PATCH[topic]) {
                    bunny.__EPSAGON_PATCH[topic] = true; // eslint-disable-line no-underscore-dangle
                    // eslint-disable-next-line no-param-reassign
                    handlers[topic] = (...args) => traceContext.RunInContext(
                        tracer.createTracer,
                        () => bunnybusSubscriberMiddleware(
                            this.config,
                            callback,
                            queue,
                            topic,
                            ...args
                        )
                    );
                }
            });
        } else {
            utils.debugLog('Skipping BunnyBus consumer tracing since meta is disabled.');
        }
        return wrappedFunction.apply(this, [queue, handlers, options]);
    };
}

module.exports = {
    /**
     * Initializes the BunnyBus tracer
     */
    init() {
        moduleUtils.patchModule(
            '@tenna-llc/bunnybus/lib/index.js',
            'subscribe',
            bunnybusConsumerWrapper,
            BunnyBus => BunnyBus.prototype
        );
    },
};