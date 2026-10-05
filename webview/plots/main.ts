import { mountPlotWorkspace } from "./workspace";
declare function acquireVsCodeApi():{postMessage(v:unknown):void;setState(v:unknown):void;getState():unknown};
const workspace=mountPlotWorkspace(document.getElementById("plot-app")!,acquireVsCodeApi());
window.addEventListener("message",event=>workspace.receive(event.data));
