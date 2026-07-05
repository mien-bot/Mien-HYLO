import ElectronStore from 'electron-store'

// electron-store v11 uses ESM default export which gets wrapped
// when externalized by electron-vite. Handle both cases.
const StoreClass =
  (ElectronStore as typeof ElectronStore & { default?: typeof ElectronStore }).default ||
  ElectronStore
const store = new StoreClass({
  deserialize: (value: string) => JSON.parse(value.replace(/^\uFEFF/, '')),
}) as ElectronStore

export default store
