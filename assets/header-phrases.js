(function () {
  const phrases = [
    "it's one question, just answer it",
    "remember Wordle? it's like if Wordle was a survey",
    "not everything has to be the worst",
    "if your friend was also your employee engagement survey",
    "the robots that analyze the survey are programmed to be nice",
    "the world is a nightmare but this one thing can be fun",
    "ping lowers the likelihood of unpaid team building events",
    "the engagement survey with the highest % of memes"
  ];

  const targets = document.querySelectorAll(".tagline, .script");
  if (!targets.length || !phrases.length) return;

  const storageKey = "pingWebsiteHeaderPhraseIndex";
  const storedIndex = Number.parseInt(window.localStorage.getItem(storageKey) || "0", 10);
  let index = Number.isNaN(storedIndex) ? 0 : storedIndex % phrases.length;

  function renderPhrase() {
    targets.forEach((target) => {
      target.textContent = phrases[index];
    });
  }

  function advancePhrase() {
    index = (index + 1) % phrases.length;
    window.localStorage.setItem(storageKey, String(index));
    renderPhrase();
  }

  renderPhrase();

  window.setInterval(advancePhrase, 5000);
})();
