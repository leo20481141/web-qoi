# Web QOI

This project brings the **QOI image format** to the web, making it easy to embed QOI images on any website without much hassle.

All you need to do is copy **`index.css`** and **`worker.js`** into your project and register the worker. That’s it!

You don’t need to write complex code, understand how QOI, BMP, or any other image format works or understand how the converssion works, you just need to copy a few files, and you’ll have **native-like QOI image support** in your project.

---
## How to integrate into a project

1. **Copy** `worker.js`
2. **Open** your `main.js` and paste this code:
```js
navigator.serviceWorker.register("./worker.js");
```
3. **Open** your `index.css` or `main.css` and paste this code:
```css
img[src$=".qoi"] {
    transform: scaleY(-1);
}
```
4. That’s all — enjoy QOI image support in your project!
---