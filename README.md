<p align="center">
<a href="https://fullstacked.org/">
<img src="https://files.cplepage.com/fullstacked/favicon.png" alt="FullStacked Logo" width="50px" />
</a>
</p>
<h1 align="center">FullStacked CLI</h1>
<h3 align="center">Web development at its finest</h3>
<p align="center">
<a href="https://www.npmjs.com/package/@fullstacked/cli"><img src="https://badgen.net/npm/v/@fullstacked/cli" alt="version"/>
</a>
</p>

> **Warning** <br />
> While FullStacked CLI is probably the most efficient tool you'll ever use, bear in mind that it evolves very fast. 

FullStacked CLI provides a whole set of commands and utilities useful for the whole web app lifecycle :
 
**Commands**
 * [create](https://www.npmjs.com/package/@fullstacked/create)
 * [build](https://www.npmjs.com/package/@fullstacked/build)
 * [run](https://www.npmjs.com/package/@fullstacked/run)
 * [watch](https://www.npmjs.com/package/@fullstacked/watch)
 * [deploy](https://www.npmjs.com/package/@fullstacked/deploy)
 * [backup (& restore)](https://www.npmjs.com/package/@fullstacked/backup)

**Utilities**
 * [sync](https://www.npmjs.com/package/@fullstacked/sync)
 * [gui](https://www.npmjs.com/package/@fullstacked/gui)
 * [ide](https://www.npmjs.com/package/@fullstacked/ide)
 * [webapp](https://www.npmjs.com/package/@fullstacked/webapp)
 
## Usage
#### Requirements
* NodeJS `>= 18.x` [https://nodejs.org/](https://nodejs.org/)
##### Optional
* Docker and Docker-Compose [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)
 
#### Getting Started

1. Create a folder where you will develop your awesome web app
```shell
mkdir my-awesome-project
cd my-awesome-project
```
2. Init fullstacked with npm
```shell
npm init @fullstacked@latest
```
3. Startup you project locally!
```shell
npm start
```
Open [http://localhost:8000](http://localhost:8000/) and start developing!

## Motivation
As many web developer, I have changed my toolset very often. We waste
so much time on configs and figuring out how to build and deploy web apps. FullStacked aims to skip
all the configuration phases to instead allow you to start developing as quickly as possible!

I also really like the iterative approach, so I look forward to implementing ways to help with 
sharing development environments for the purpose of testing and reviewing.
