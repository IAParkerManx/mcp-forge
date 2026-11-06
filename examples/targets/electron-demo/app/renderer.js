const list = document.getElementById("notes");
async function refresh() {
  const { notes } = await window.desknotes.listNotes();
  list.replaceChildren(...notes.map((n) => Object.assign(document.createElement("li"), { textContent: n.title })));
}
document.getElementById("refresh").addEventListener("click", refresh);
refresh();
