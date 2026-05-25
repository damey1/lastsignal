/**
 * LastSignal — Service Worker for push notifications
 */
self.addEventListener("push", (event) => {
  const data = event.data?.json();
  // Skip silent cleanup pings (no body = not a real notification)
  if (!data || !data.body) return;

  const options = {
    body: data.body,
    icon: data.icon || "/favicon.ico",
    badge: "/favicon.ico",
    data: data.data || {},
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/app.html";
  event.waitUntil(clients.openWindow(url));
});
