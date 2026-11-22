# Teeko

Teeko 是一个面向 8–13 岁孩子的 AI 英语陪学工具。孩子选一个感兴趣的主题，用语音跟老师学。老师按当前页的教案讲解、提出问题，并在支持的课堂里标注教材。

## 制作教材

从[教材制作手册](courses/AUTHORING.md)开始。手册末尾的首轮任务可以直接交给 Grok。参考[原创两页纸飞机教材](courses/drafts/paper-glider/1/course.json)和[样例制作说明](courses/drafts/paper-glider/1/AUTHOR-NOTES.md)。草稿通过文件检查和人工复核后，由应用维护者接入课程目录。

```sh
npm run courses:check -- courses/drafts/paper-glider/1
```

## 本地运行

使用 Node.js 24.15 或更新的 24.x 版本及 npm。

```sh
npm ci
npm run build:node
APP_ORIGIN=http://127.0.0.1:8080 npm run start:node
```

默认端口为 8080。主题列表在 `/topics`。公开列表和教材预览可先浏览。注册及实时课堂需要自己的 PostgreSQL、发信服务和语音服务配置。参照 [.env.example](.env.example) 建一个本地忽略的 `.env.local`，为此版本新建数据库，然后运行以下命令。

```sh
node --env-file=.env.local scripts/migrate-accounts.mjs
node --env-file=.env.local scripts/run-node-framework.mjs start
```

公开版的机器人课程采用原创带读文案。课程发布校验同一版本的内容哈希，所以请为这个快照使用新的数据库。

## 开发和协作

```sh
npm run typecheck
npm test
```

两台电脑从同一仓库克隆，分别在自己的分支工作，提交前从 `main` 更新。课程草稿和应用代码可以分开提交，开 PR 后一起复核。各机器单独配置服务凭据。工作约定见 [AGENTS.md](AGENTS.md)。

项目自有代码、制作手册及原创两页样例采用 [MIT](LICENSE)。第三方代码、字体和依赖的声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
