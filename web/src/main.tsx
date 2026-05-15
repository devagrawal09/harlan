import { Loading, render } from "@solidjs/web";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element.");
}

render(
  () => (
    <Loading fallback={<main class="app-shell loading-shell">Loading Harlan</main>}>
      <App />
    </Loading>
  ),
  root,
);
