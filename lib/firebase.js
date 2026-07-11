// lib/firebase.js
// Firebase Admin 초기화를 한 곳으로 모아 어떤 모듈이 먼저 require되든
// admin.initializeApp()이 정확히 한 번만 실행되도록 보장한다.
// Cloud Run 환경에서는 별도 키 파일 없이 서비스 계정(런타임 서비스 ID)으로
// 자동 인증됩니다. 로컬 테스트 시에는 GOOGLE_APPLICATION_CREDENTIALS 환경변수로
// 서비스 계정 키 json 경로를 지정하세요.
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || "m-smart-90148",
  });
}

const db = admin.firestore();

module.exports = { admin, db };
