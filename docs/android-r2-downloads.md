# Cloudflare R2：App 内更新

> 历史方案，仅供旧版本参考。当前 OTA 请使用[日本服务器部署流程](android-ota-updates.md#日本服务器部署)。

计划使用 `https://download.xunxin.shop/android/version.json`。自动模式先检查该地址，失败时检查原 GitHub 清单。清单提供 R2 下载链接和 GitHub 备用链接，两者对应同一签名 APK 和 SHA-256。更新弹窗可以选线路，下载时显示当前域名；暂停后选另一线路会重新下载，原有摘要和签名检查不变。

## 域名和存储桶

1. 在 Cloudflare 添加 `xunxin.shop`，选 Free 计划。切换前从 Spaceship 记录或导出完整 DNS 配置，把所有主站、子域名、API、邮件和验证记录核对到 Cloudflare，原有站点初次迁移先使用 DNS only，避免同时更改代理行为。若启用了 DNSSEC，按 [Cloudflare 指引](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/) 处理旧 DS，再在 Spaceship 设置 Cloudflare 分配的两条 Nameserver。保留原记录备份。
2. 同一 Cloudflare 账号开通 R2 后，创建专用 Standard 存储桶 `xunxin-android-releases`。只放公开安装包与更新清单；在桶的 **Settings → Custom Domains** 连接 `download.xunxin.shop`，等待 Active，`r2.dev` 可保持关闭。[自定义域名说明](https://developers.cloudflare.com/r2/buckets/public-buckets/)
3. 只给本机发布者配置该桶的对象读写权限，将 R2 S3 凭据保存在本机 AWS CLI 专用 profile（例如 `xunxin-r2`）。不要把凭据写入源码、清单或发布日志，也不需要上传 APK 签名私钥。
4. 如设置 Cloudflare 缓存规则，只匹配下载域名的 `/android/releases/` 路径；更新清单 `/android/version.json` 保持不缓存。Standard 免费额度和超额计费见 [官方定价](https://developers.cloudflare.com/r2/pricing/)；免费 Cloudflare 全球网络不等同于中国大陆专用节点。

## 首次上线与后续发布

用已签名并发布到 GitHub 的 APK 初始化 R2。该命令核对 GitHub 资产摘要，先上传版本化 APK，确认域名支持 Range，再发布更新清单。

```powershell
python scripts/publish-android-r2.py --apk <签名APK> --manifest <该版本version.json> --base-url https://download.xunxin.shop --endpoint <R2的S3接口地址> --bucket xunxin-android-releases --profile xunxin-r2 --output <本机输出目录>/version.json
```

R2 清单可用后再设置 GitHub 仓库变量 `SHELL_UPDATE_MIRROR_URL=https://download.xunxin.shop/android/version.json`，并触发 Android 构建。未设置变量的旧 APK 仍从 GitHub 检查更新。首次发布接入 R2 的正式版时，先把 APK 发到 GitHub，再镜像至 R2，最后用包含 R2 主地址的清单更新 GitHub 稳定通道，现有 1.0.2 可从那里发现新版。

后续执行 `scripts/publish-android-local.py` 时，除了已有签名参数，传入 `--r2-endpoint`、`--r2-bucket`、`--r2-base-url`、`--r2-profile`；也可设置 `XUNXIN_R2_ENDPOINT`、`XUNXIN_R2_BUCKET`、`XUNXIN_R2_BASE_URL`、`XUNXIN_R2_PROFILE`。Cloudflare 凭据仅由本机 AWS CLI 读取。如果 R2 发布失败，现有 GitHub 稳定通道不会提前切换；修复后可用同一已签名包和已发布资产恢复镜像，再上传镜像生成的 `version.json` 到 GitHub 稳定通道。
