import React from "react";
import { createRoot } from "react-dom/client";
import Wire from "./App.jsx";
import "./index.css";
import "./styles/wire.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Wire />
  </React.StrictMode>
);
