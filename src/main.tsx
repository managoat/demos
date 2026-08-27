import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { watchKeyboard } from "./lib/viewport";
import "./styles.css";

// Outside React: it is the document element's height, it outlives every route,
// and on anything but a touch screen it attaches nothing at all.
watchKeyboard(window, document.documentElement);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
