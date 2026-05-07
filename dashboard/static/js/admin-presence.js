(function () {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${window.location.host}/ws/presence`);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "force.logout") {
        window.location.href = "/login";
      }
    } catch (_) {}
  };

  ws.onopen = () => {
    try { ws.send("ping"); } catch (_) {}
  };
})();
