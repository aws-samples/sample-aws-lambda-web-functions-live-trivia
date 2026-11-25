// The runtime loads /var/task/index.js.
// Node 24 strips the types from the imported .ts at load; keep app.ts (and all
// .ts it imports) in the deploy ZIP.
import './src/app.ts';
