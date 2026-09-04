import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadTheme, saveTheme } from "./lib/theme";
import "./styles.css";

// Apply the saved palette before React paints the shell.
saveTheme(loadTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
