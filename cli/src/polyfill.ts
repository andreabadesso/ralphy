/**
 * Polyfill for environments where process.stdout/stderr or their file descriptors are undefined
 */
// @ts-nocheck
(function() {
    if (typeof process === 'undefined') {
        globalThis.process = { 
            env: {}, 
            argv: [], 
            platform: 'darwin',
            nextTick: (fn) => setTimeout(fn, 0)
        };
    }

    if (!process.stdout) {
        process.stdout = {
            fd: 1,
            write: function(str) { console.log(str); },
            isTTY: false
        };
    } else if (typeof process.stdout.fd === 'undefined') {
        try {
            process.stdout.fd = 1;
        } catch (e) {
            // If read-only, try to define it
            Object.defineProperty(process.stdout, 'fd', { value: 1, configurable: true });
        }
    }

    if (!process.stderr) {
        process.stderr = {
            fd: 2,
            write: function(str) { console.error(str); },
            isTTY: false
        };
    } else if (typeof process.stderr.fd === 'undefined') {
        try {
            process.stderr.fd = 2;
        } catch (e) {
            // If read-only, try to define it
            Object.defineProperty(process.stderr, 'fd', { value: 2, configurable: true });
        }
    }
})();
