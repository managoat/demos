import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, storedTheme } from "./lib/theme";
import "./styles.css";
import "./styles/shell.css";
import "./styles/pickers.css";
import "./styles/thread.css";
import "./styles/inspector.css";

// Before the first paint, so there is no frame of the default palette in front
// of the chosen one.
applyTheme(storedTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
