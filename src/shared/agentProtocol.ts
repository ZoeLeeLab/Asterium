/**
 * Compatibility barrel for the public agent protocol.
 *
 * Keep existing imports stable while definitions live in focused contract
 * modules. New code may import a focused module when it does not need the full
 * public surface.
 */
export * from './contracts/attachments';
export * from './contracts/connections';
export * from './contracts/core';
export * from './contracts/profiles';
export * from './contracts/runtime';
