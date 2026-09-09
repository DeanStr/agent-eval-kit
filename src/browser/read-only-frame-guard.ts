import type { BrowserContext } from "playwright";

/** Observe before application scripts: tightening an attribute does not revoke
 * permissions of an already loaded iframe document. Require an empty sandbox
 * from attachment onward; a changed iframe must be replaced to regain access. */
export async function installReadOnlyFrameGuard(
  context: BrowserContext,
  key: string,
): Promise<void> {
  // Keep browser bootstrap code literal so TypeScript runners cannot inject
  // module-local helpers that do not exist in the page's execution context.
  await context.addInitScript({
    content: `(() => {
    if (window !== window.top) return;
    const seen = new WeakSet();
    const rejected = new WeakSet();
    const shadowRoots = new WeakMap();
    const observedRoots = new WeakSet([document]);
    const inspect = element => {
      if (!(element instanceof HTMLIFrameElement)) return;
      seen.add(element);
      if (!element.hasAttribute("sandbox") || element.sandbox.length !== 0) rejected.add(element);
    };
    const record = records => {
      for (const mutation of records) {
        if (mutation.type === "attributes") rejected.add(mutation.target);
        else for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          inspect(node);
          for (const frame of node.querySelectorAll("iframe")) inspect(frame);
        }
      }
    };
    const observer = new MutationObserver(record);
    const observation = {subtree:true,childList:true,attributes:true,attributeFilter:["sandbox"]};
    observer.observe(document, observation);
    // Observe open and closed roots before application code can populate them.
    // Discovering an already populated root cannot establish attachment history.
    const attachDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");
    const attachShadow = attachDescriptor.value;
    Object.defineProperty(Element.prototype, "attachShadow", { ...attachDescriptor, value: function(init) {
      const root = Reflect.apply(attachShadow, this, [init]);
      shadowRoots.set(this, root);
      observer.observe(root, observation);
      observedRoots.add(root);
      return root;
    }});
    const rejectTree = node => {
      if (!(node instanceof Element)) return;
      if (node instanceof HTMLIFrameElement) rejected.add(node);
      const shadow = shadowRoots.get(node);
      if (shadow) for (const child of shadow.children) rejectTree(child);
      for (const child of node.children) rejectTree(child);
    };
    // State-preserving moves retain loaded documents, including frames inside
    // a moved shadow host. Preserve the policy's unconditional move rejection.
    for (const prototype of [Document.prototype, DocumentFragment.prototype, Element.prototype]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "moveBefore");
      if (typeof descriptor?.value !== "function") continue;
      const moveBefore = descriptor.value;
      Object.defineProperty(prototype, "moveBefore", { ...descriptor, value: function(node, child) {
        rejectTree(node);
        return Reflect.apply(moveBefore, this, [node, child]);
      }});
    }
    Object.defineProperty(window, ${JSON.stringify(key)}, {
      value: Object.freeze({ allows(element) {
        record(observer.takeRecords());
        return observedRoots.has(element.getRootNode()) && seen.has(element) && !rejected.has(element);
      } }), writable:false, configurable:false,
    });
  })();`,
  });
}
