const section = document.body.dataset.section;
const links = document.querySelectorAll("[data-section-link]");

links.forEach((link) => {
  link.classList.toggle("is-active", link.dataset.sectionLink === section);
});
