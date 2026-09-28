# 故障排查

| 现象 | 处理方式 |
| --- | --- |
| `fetch failed` | 检查 ComfyUI 是否启动、端口是否正确；用 `npm run doctor` 复查 |
| `Missing ComfyUI node` | 当前服务没有加载要求的节点。核对 ComfyUI 版本及启动日志 |
| `Unavailable value` | 模型文件名不同或缺失。在 `config.local.json` 指定实际文件名 |
| `ComfyUI has other work queued` | 等待已有工作完成后再运行，不要清空别人的任务 |
| 显存不足或很慢 | 降低尺寸、缩短镜头、检查其他 GPU 程序；低显存启动参数由你的 ComfyUI 安装管理 |
| 一直显示 Waiting | 这是历史轮询，不是采样百分比。打开 ComfyUI 查看加载与采样阶段 |
| 客户端等待超时 | 原任务可能仍在运行，用 `resume output/<job>/job.json` 继续查询 |
| 完成后没有视频 | 确认工作流有 SaveVideo 输出。客户端不会把空结果当作成功 |
| Hypit 找不到 FFmpeg | 运行 `node bin/setup-hypit.mjs` 并选择生成的本机 Runtime Profile |
| npm 的安装脚本被禁用 | 检查包管理器策略，按包审批官方依赖的安装脚本；FFmpeg 下载需要网络 |
| Hypit 浏览器准备失败 | 查看 `runtime up` 日志；也可通过 `HYPIT_CHROME_PATH` 为 setup 脚本指定兼容的已有 Chrome |
| Hypit 渲染失败 | 保留已生成的 source 文件，修复合成配置后新建 Build；不需要重新生成 H3 |

请在 Issue 中提供 Node、ComfyUI、Hypit 版本、错误文本和去除私人内容后的配置。不要上传访问令牌、私人素材或整个模型目录。
