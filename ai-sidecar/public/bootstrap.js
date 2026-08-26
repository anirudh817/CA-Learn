import { AIInsightsApp } from "/app.js?v=deep-research-v2";

const root = document.getElementById("ai-insights-root");
if (!root) throw new Error("AI Insights root element is missing");
AIInsightsApp.mount(root);
