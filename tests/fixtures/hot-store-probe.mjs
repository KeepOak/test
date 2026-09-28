/* Opens Branch's database from a second process, as a newer engine would, and says whether it was let in. */
const { Store } = await import("../../dist/store.js");
try {
  const store = new Store(process.argv[2]);
  store.close();
  console.log("opened");
} catch (error) {
  console.log(`refused: ${error instanceof Error ? error.message : String(error)}`);
}
