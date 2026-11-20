import { startFakeMagentoServer } from './fake-magento-server.js';

/** Entry for the restart acceptance container: PORT (default 3003) and PRODUCTS (default 400); control routes on. */
const port = Number(process.env.PORT ?? '3003');
const products = Number(process.env.PRODUCTS ?? '400');
await startFakeMagentoServer({ host: '0.0.0.0', port, products, control: true });
console.log(`fake Magento server listening on ${port} with ${products} products`);
