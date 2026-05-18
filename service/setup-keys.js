/**
 * Generate VAPID keys for Web Push notifications.
 * Run once: node setup-keys.js
 */
import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log("VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("VAPID_PRIVATE_KEY=" + keys.privateKey);
console.log("\nAdd these to your .env file.");
