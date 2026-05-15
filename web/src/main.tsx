import { Errored, Loading, render } from "@solidjs/web";
import App from "./App";
import "./styles.css";

const loadingShellClass =
  "grid min-h-screen grid-cols-1 place-items-center bg-[#f6f7f4] font-sans text-[#66706a] [font-synthesis:none] [text-rendering:optimizeLegibility] min-[761px]:grid-cols-[260px_minmax(0,1fr)]";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element.");
}

render(
  () => (
    <Errored fallback={(error) => <main class={loadingShellClass}>{String(error())}</main>}>
      <Loading fallback={<main class={loadingShellClass}>Loading Harlan</main>}>
        <App />
      </Loading>
    </Errored>
  ),
  root,
);
