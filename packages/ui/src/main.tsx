import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { WebLockGate } from "./WebLockGate.tsx";
import "./styles.css";
import { followVisualViewport } from "./viewport.ts";

followVisualViewport();

createRoot(document.getElementById("root")!).render(<StrictMode><WebLockGate><App /></WebLockGate></StrictMode>);
