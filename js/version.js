// アプリの版。画面の題名（国道走破マップ v0.2）とサービスワーカーのキャッシュ名の両方が
// これを使う。画面・JS・CSS・data/ のどれかを更新したら上げること。上げないと端末に
// 古いものが配られ続ける。sw.js は importScripts、index.html は <script> で読む
"use strict";
const APP_VERSION = "0.3";
