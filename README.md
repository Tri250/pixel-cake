# pixel-cake（LADB）

> 一个把 ADB 服务端打包进 APK 的本地 ADB 终端。Android 8.0+ 无需 root、无需电脑即可在本机执行 adb shell 命令。
>
> 本仓库由 **带娃的小陈工** 维护，上游项目为 [tytydraco/LADB](https://github.com/tytydraco/LADB)。
> 在 2.0.0 版本中对数据层（DataStore）、会话生命周期、稳定性与安装/卸载体验做了系统重构。

---

## 工作原理

应用自带 ADB 服务端（`libadb.so`）。正常情况下，它无法连接到本机，因为 ADB 需要一条 USB 链路；
但 Android 的「无线调试」功能允许服务端与客户端在本机通过 TCP 互相通信，LADB 正是利用这一点：
通过 mDNS 发现无线调试广播出来的端口，连接后再给自己授权 `WRITE_SECURE_SETTINGS`。

## 安装要求

| 项目 | 要求 |
| --- | --- |
| 系统版本 | Android 8.0（API 26）及以上，targetSdk 36 |
| CPU 架构 | `arm64-v8a`、`x86_64`（发布包只包含这两种 ABI） |
| 安装位置 | 仅内部存储（`installLocation=internalOnly`），因为原生库必须可执行 |
| 首次使用 | 需开启「开发者选项 → 无线调试」，并完成一次配对 |

### 安装与卸载

- **安装**：下载 Release 中的 `LADB-<版本>.apk`。若已装过旧签名（开发版）构建，需先卸载一次，之后可正常覆盖升级。
- **卸载**：常规卸载即可。设置、书签、命令历史保存在应用私有 DataStore 中，会随卸载一并清除；
  终端输出缓存位于 `cache/ladb_output.txt`，同样随卸载回收，且已被排除在备份规则之外。
- **备份**：Android 12+ 使用 `dataExtractionRules`，仅备份设置/书签/历史，不备份终端缓存。

## 首次配对

1. 打开系统「设置 → 开发者选项 → 无线调试」；
2. 点「使用配对码配对设备」，记下**端口号**与**配对码**；
3. 在 LADB 的配对弹窗中填入端口与配对码（建议用分屏/悬浮窗，避免系统对话框被关闭导致配对失效）；
4. 配对成功后端口会被记住，下次启动走「缓存端口快连」，不再重新发现。

若不需要 adb shell，可在配对弹窗点「跳过」，或到「更多 → Pair & shell」关闭，进入普通 shell。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 一直卡在 Waiting | 确认无线调试已开启；用「更多 → Restart」重启服务端；必要时清除应用数据并删除所有无线调试配对后重启手机 |
| 与 Shizuku 冲突 | 两者不兼容，需卸载 Shizuku 并重启 |
| 页面大小不兼容提示 | 见下方「16KB 页面设备」 |
| 缓存端口失效 | 会自动回落到 mDNS 发现流程，无需手动处理 |

### 16KB 页面设备（Android 15+ 部分机型）

Android 15 起部分设备使用 16KB 内存页。随包分发的 `libadb.so` 是预编译二进制，
其 ELF LOAD 段对齐为 4KB，**在 16KB 页面设备上无法执行**。应用会在启动时自检并把原因
打印到终端（而不是静默失败）。彻底解决需要用 NDK r26+ 重新链接：

```bash
-Wl,-z,max-page-size=16384
```

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `INTERNET` | ADB 需要通过 TCP 连接本机无线调试端口 |
| `ACCESS_NETWORK_STATE` | 判断当前网络，用于 mDNS 发现 |
| `WRITE_SECURE_SETTINGS` | 切换无线调试开关；未经 adb 授权时应用会自动申请，失败时仅降级提示、不影响启动 |

应用不上传任何设备数据，所有 shell 输出只存在本机。

## 构建

```bash
./gradlew assembleDebug          # 调试包
./gradlew assembleRelease        # 发布包（未签名，签名在 CI 中完成）
./gradlew lintDebug testDebugUnitTest
```

要求 JDK 21（CI 使用 temurin 21）、Android SDK compileSdk 36。

## License

上游版权归 Tyler Nijmeh 所有，许可证见 [LICENSE](./LICENSE)。
本仓库修改部分版权归 带娃的小陈工 所有。许可证禁止除原作者外的任何人将本项目发布到 Google Play。
