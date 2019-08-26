#!/usr/bin/env node
const fs = require('fs')
const {join, resolve, relative, dirname} = require('path')
const pull = require('pull-stream')
const ssbClient = require('scuttlebot-release/node_modules/ssb-client')
const ssbKeys = require('scuttlebot-release/node_modules/ssb-keys')
const {exec} = require('child_process')
const multicb = require('multicb')
const file = require('pull-file')
const htime = require('human-time')
const argv = require('rc')('treos')

const {debug, dryRun, force, noCommitLog} = argv

if (argv._.length<1) {
  console.error('USAGE: treos-deploy ISSUE.JSON [--dryRun] [--force] [--noCommitLog]')
  process.exit(1)
}

const issueFile = resolve(argv._[0])
console.error('issue:', issueFile)

let issue
try {
  issue = JSON.parse(fs.readFileSync(issueFile))
} catch(err) {
  console.error(err.message)
  process.exit(1)
}
const sourcePath = dirname(issueFile)
console.error('source path:', sourcePath)

const conf = require('rc')('tre')
const path = conf.config
if (!path) {
  console.error('.trerc not found')
  process.exit(1)
}
const keys = ssbKeys.loadSync(join(path, '../.tre/secret'))

isClean(sourcePath, (err, clean) => {
  if (err || !clean) {
    if (!force) process.exit(1)
    console.error('(--force is set, so we continue anyway')
  }

  const basic = {
    type: 'system',
    name: argv.name,
    description: argv.description,
    root: conf.tre.branches.root,
    branch: conf.tre.branches.systems
  }

  const done = multicb({pluck:1, spread: true})

  upload(sourcePath, conf, keys, issue, done())
  gitInfo(sourcePath, done())
   
  done( (err, files, git) => {
    if (err) {
      console.error(err.message)
      process.exit(1)
    }
    const tre = conf.tre

    const content = Object.assign({},
      basic,
      git,
      {name: `${basic.name} [${git.repositoryBranch.substr(0, 4)}]`},
      issue
    )
   
    console.log(content)

    publish(sourcePath, conf, keys, content, (err, kv) => {
      if (err) {
        console.error('Unable to publish', err.message)
        process.exit(1)
      }
      console.error('Published as', kv.key)
      console.log(kv)
    })
  })
})


function upload(sourcePath, conf, keys, issue, cb) {
  ssbClient(keys, Object.assign({},
    conf, { manifest: {blobs: {
      add: 'sink',
      has: 'async'
    }} }
  ), (err, ssb) => {
    if (err) return cb(err)

    const keys = 'kernels initcpios diskImages'.split(' ')
    const files = keys.reduce( (acc, key) => {
      Object.keys(issue[key]).map(k=>{
        const o = issue[key][k]
        acc.push({
          name: k,
          type: key,
          path: o.path,
          checksum: o.checksum,
          size: o.size
        })
      })
      return acc
    }, [])

    files.push(Object.assign({
      name: 'packages.shrinkwrap',
      type: 'ssb-pacman shrinkwrap file',
    }, issue.shrinkwrap))

    pull(
      pull.values(files),
      pull.through(f => {
        f.path = resolve(sourcePath, f.path)
        return f
      }),
      pull.asyncMap( (f, cb) =>{
        ssb.blobs.has(`&${f.checksum}`, (err, has) =>{
          if (err) return cb(err)
          console.log(`File ${f.name} does ${has ? '' : 'not'} already exist as a blob`)
          f.exists = has
          cb(null, f)
        })
      }),
      pull.asyncMap( (f, cb) => {
        if (f.exists) {
          return cb(null, f)
        }
        pull(
          file(f.path),
          ssb.blobs.add( (err, hash) =>{
            if (hash !== `&${f.checksum}`) {
              return cb(new Error(`checksum mismatch: ${f.name} ${hash} should be &${f.checksum}`))
            }
            console.log(`${f.name}: blobs.add complete`)
            cb(null, f)
          })
        )
      }),
      pull.collect( (err, result) =>{
        ssb.close()
        cb(err, result)
      })
    )
  })
}

function publish(path, conf, keys, content, cb) {
  ssbClient(keys, Object.assign({},
    conf,
    {
      manifest: {
        publish: 'async',
        revisions: {
          messagesByType: 'source'
        }
      }
    }
  ), (err, ssb) => {
    if (err) return cb(err)
    const systems = []
    pull(
      ssb.revisions.messagesByType('system'),
      pull.drain( e =>{
        const revRoot = e.key.slice(-1)[0]
        const content = e.value.value.content
        console.error('',
          `${revRoot.substr(0,5)}:${e.value.key.substr(0,5)}`, content.name, content.repositoryBranch, content.commit, htime(new Date(e.value.value.timestamp)), 'by', e.value.value.author.substr(0, 5))
        systems.push(e.value) // kv
      }, err => {
        if (err) return cb(err)
        const system = findSystem(keys.id, systems, content)
        if (!system) {
          console.error('First deployment of this system')
        } else {
          content.revisionBranch = system.key
          content.revisionRoot = revisionRoot(system)
          console.error('Updating existing system', content.revisionRoot.substr(0, 5))
        }
        getLogMessages(path, system, content, (err, commits) => {
          if (err) {
            ssb.close()
            return cb(err)
          }
          if (noCommitLog) {
            commits = []
          }
          content['new-commits'] = commits || []
          if (dryRun) {
            ssb.close()
            return cb(null, {value: content})
          }
          ssb.publish(content, (err, kv) => {
            ssb.close()
            if (err) return cb(err)
            cb(null, kv)
          })
        })
      })
    )
  })
}

function getLogMessages(cwd, system, content, cb) {
  if (!content.commit) return cb(null, [])
  const before = system && system.value.content.commit || ''
  const after = content.commit
  //if (!before || !after) return cb(null, [])
  if (before.includes('dirty') || after.includes('-dirty')) return cb(null, null)
  console.error(`getting git log messages ${before}..${after}`)
  exec(`git log --pretty=oneline ${before ? before+'..':''}${after}`, {cwd}, (err, logs) => {
    if (err) return cb(err)
    const lines = logs.split('\n').filter(Boolean)
    cb(null, lines)
  })
}

function findSystem(author, kvs, content) {
  const {repository, repositoryBranch} = content
  const kv = kvs.find( ({key, value}) => {
    if (debug) console.error(`${key.substr(0,5)}: `)
    const {content} = value
    if (value.author !== author) {
      if (debug) console.error('wrong author')
      return false
    }
    if (content.repository !== repository) {
      if (debug) console.error('wrong repo')
      return false
    }
    if (content.repositoryBranch !== repositoryBranch) {
      if (debug) console.error('wrong repo branch')
      return false
    }
    return true
  })
  return kv
}

function isClean(cwd, cb) {
  exec('git status --porcelain', {cwd}, (err, status) => {
    if (err) {
      console.error('git status failed', err.message)
      return cb(err)
    }
    if (status.replace(/\n/g,''.length)) {
      console.error(`\nWorking directory is not clean: ${cwd}\n`)
      console.error(status)
      console.error('\nPlease commit and try again.\n')
      return cb(null, false)
    }
    cb(null, true)
  })
}

function gitInfo(cwd, cb) {
  const done = multicb({pluck: 1, spread: true})

  exec('git describe --dirty --always', {cwd}, done())
  exec('git remote get-url origin', {cwd}, done())
  exec('git symbolic-ref --short HEAD', {cwd}, done())

  done( (err, ref, url, branch) => {
    if (err) return cb(err)
    cb(null, {
      commit: ref.replace(/\n/,''),
      repository: url.replace(/\n/,''),
      repositoryBranch: branch.replace(/\n/,'')
    })
  })
}

function revisionRoot(kv) {
  return kv.value.content.revisionRoot || kv.key
}
