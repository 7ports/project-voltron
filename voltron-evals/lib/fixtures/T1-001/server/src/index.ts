import express from "express";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// VOLTRON_EVAL_ANCHOR: register routes here
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/", (_req, res) => {
  res.json({ name: "voltron-evals-fixture", version: "0.0.1" });
});

app.listen(PORT, () => {
  console.log(`fixture listening on :${PORT}`);
});
