// MuPDF reads this module option during its first import. Keep it before the
// dynamic import so each document worker can report its own WASM heap size.
globalThis.$libmupdf_wasm_Module = {};
await import('./worker-runtime');
export {};
