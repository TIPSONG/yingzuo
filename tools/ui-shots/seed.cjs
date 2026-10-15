'use strict';
// Only user-facing controls are used; never paint fake HTML over a loading or error state.
function seedPage(id) {
  const pageId = id.startsWith('assets-') ? 'assets' : id === 'favorites' ? 'assets' : id === 'create-start' ? 'create' : id === 'settings-lower' ? 'settings' : id;
  const nav = document.querySelector(`nav .nav[data-page="${pageId}"]`);
  if (!nav) throw new Error(`Unknown screenshot page: ${id}`);
  nav.click();
  if (id === 'create-start') document.getElementById('new-tab').click();
}
module.exports = {seedPage};
