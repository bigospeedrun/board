// GA4 for the Big O Speedrun race boards: the site's property and settings
// (bigospeedrun/site public/analytics.js). Production host only; advertising features
// are disabled. The board pages load it; the sign-in and account pages (/auth/) do not.
(function () {
  if (location.hostname !== "board.bigospeedrun.com") {
    return;
  }

  var MEASUREMENT_ID = "G-MZ689LR3LG";

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", MEASUREMENT_ID, {
    anonymize_ip: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  var tag = document.createElement("script");
  tag.async = true;
  tag.src = "https://www.googletagmanager.com/gtag/js?id=" + MEASUREMENT_ID;
  document.head.appendChild(tag);
})();
