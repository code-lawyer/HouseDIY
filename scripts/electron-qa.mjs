import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

let requestSequence = 0;

// Native capturePage explicitly supports hidden Electron windows.
export async function captureNativeWindow(socket, outputFile) {
  const reply = await new Promise((resolve, reject) => {
    const id = ++requestSequence;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => fail(new Error("Native capture connection closed"));
    const onError = () => fail(new Error("Native capture connection failed"));
    const onMessage = (message) => {
      let result;
      try {
        result = JSON.parse(message.data);
      } catch (error) {
        fail(error);
        return;
      }
      if (result.id !== id) return;
      if (result.result?.exceptionDetails || result.error) {
        fail(new Error(JSON.stringify(result)));
        return;
      }
      cleanup();
      resolve(result.result?.result?.value);
    };
    const timer = setTimeout(
      () => fail(new Error("Native capture timed out")),
      30000,
    );
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    try {
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression:
              "(async()=>{const contents=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents;contents.setBackgroundThrottling(false);await contents.capturePage(undefined,{stayHidden:true,stayAwake:true});await contents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');return (await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64')})()",
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      );
    } catch (error) {
      fail(error);
    }
  });
  const png = Buffer.from(reply, "base64");
  assert.ok(png.length > 1000, "The native capture contains a rendered image");
  writeFileSync(outputFile, png);
}
