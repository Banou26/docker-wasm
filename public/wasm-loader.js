function fetchWasm(url) {
    const startedAt = performance.now();
    return fetch(url, { credentials: 'same-origin' }).then((response) => {
        if (!response.ok) {
            throw new Error('WASM request failed for ' + url + ': HTTP ' + response.status);
        }
        return { response: response, startedAt: startedAt, url: url };
    });
}

function instantiateWasm(assetPromise, imports) {
    return assetPromise.then((asset) => {
        const contentType = asset.response.headers.get('content-type') || '';
        const canStream = typeof WebAssembly.instantiateStreaming === 'function' &&
            contentType.toLowerCase().includes('application/wasm');
        const instance = canStream
            ? WebAssembly.instantiateStreaming(asset.response, imports)
            : asset.response.arrayBuffer().then((bytes) => WebAssembly.instantiate(bytes, imports));
        return instance.then((result) => {
            const elapsedMs = Math.round(performance.now() - asset.startedAt);
            console.info('[timing] wasm-ready ' + asset.url + ': ' + elapsedMs + ' ms');
            return result;
        });
    });
}
