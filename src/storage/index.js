import * as local from "./local.js";

let _bitable = null;
async function bitable() {
  if (!_bitable) _bitable = await import("./bitable.js");
  return _bitable;
}

const useBitable = () => process.env.STORAGE_BACKEND === "bitable";

export const listItems = (collection, filter = {}) =>
  useBitable()
    ? bitable().then((b) => b.listItems(collection, filter))
    : Promise.resolve(local.listItems(collection, filter));

export const getItem = (collection, id) =>
  useBitable()
    ? bitable().then((b) => b.getItem(collection, id))
    : Promise.resolve(local.getItem(collection, id));

export const createItem = (collection, item) =>
  useBitable()
    ? bitable().then((b) => b.createItem(collection, item))
    : Promise.resolve(local.createItem(collection, item));

export const updateItem = (collection, id, updates) =>
  useBitable()
    ? bitable().then((b) => b.updateItem(collection, id, updates))
    : Promise.resolve(local.updateItem(collection, id, updates));

export const deleteItem = (collection, id) =>
  useBitable()
    ? bitable().then((b) => b.deleteItem(collection, id))
    : Promise.resolve(local.deleteItem(collection, id));
