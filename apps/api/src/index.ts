import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
const app = createApp(undefined, { log: true });

app.listen(port, "127.0.0.1", () => {
  const customerOrigin = process.env.CUSTOMER_APP_ORIGIN ?? "http://localhost:5174";
  console.log(`vkyc api  http://127.0.0.1:${port}`);
  console.log(`join urls use ${customerOrigin}`);
});
