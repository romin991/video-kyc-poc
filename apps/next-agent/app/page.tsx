import { Suspense } from "react";
import { CallStage } from "../src/CallStage";

export default function Page() {
  return (
    <Suspense fallback={<main className="shell">Loading call…</main>}>
      <CallStage />
    </Suspense>
  );
}
