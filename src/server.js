import "dotenv/config";
import app from "./app.js";
import { ensureSchemaUpdated } from "./utils/schemaMigrations.js";

// Railway (and most hosts) inject the port to bind to via PORT.
const PORT = process.env.PORT || 5001;

// Apply required columns/indexes before accepting mutation requests that rely
// on durable idempotency keys.
await ensureSchemaUpdated();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
