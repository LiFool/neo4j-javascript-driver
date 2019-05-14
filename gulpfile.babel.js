/**
 * Copyright (c) 2002-2019 "Neo4j,"
 * Neo4j Sweden AB [http://neo4j.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var browserify = require('browserify')
var source = require('vinyl-source-stream')
var buffer = require('vinyl-buffer')
var gulp = require('gulp')
var through = require('through2')
var uglify = require('gulp-uglify')
var jasmine = require('gulp-jasmine')
var babelify = require('babelify')
var babel = require('gulp-babel')
var watch = require('gulp-watch')
var batch = require('gulp-batch')
var replace = require('gulp-replace')
var fs = require('fs-extra')
var path = require('path')
var minimist = require('minimist')
var install = require('gulp-install')
var file = require('gulp-file')
var semver = require('semver')
var sharedNeo4j = require('./test/internal/shared-neo4j').default
var ts = require('gulp-typescript')
var JasmineConsoleReporter = require('jasmine-console-reporter')
var karma = require('karma')
var transformTools = require('browserify-transform-tools')
var log = require('fancy-log')

/**
 * Useful to investigate resource leaks in tests. Enable to see active sockets and file handles after the 'test' task.
 */
const enableActiveNodeHandlesLogging = false

/** Build all-in-one files for use in the browser */
gulp.task('build-browser', async function () {
  const browserOutput = 'lib/browser'
  // Our app bundler
  const appBundler = browserify({
    entries: ['src/index.js'],
    cache: {},
    standalone: 'neo4j',
    packageCache: {}
  })
    .transform(babelifyTransform())
    .transform(browserifyTransformNodeToBrowserRequire())
    .bundle()

  // Un-minified browser package
  await appBundler
    .on('error', log.error)
    .pipe(source('neo4j-web.js'))
    .pipe(gulp.dest(browserOutput))

  await appBundler
    .on('error', log.error)
    .pipe(source('neo4j-web.min.js'))
    .pipe(buffer())
    .pipe(uglify())
    .pipe(gulp.dest(browserOutput))
})

gulp.task('build-browser-test', async function () {
  const browserOutput = 'build/browser/'
  const testFiles = []

  return gulp
    .src(['./test/**/!(examples).test.js', '!./test/**/node/*.js'])
    .pipe(
      through.obj(
        function (file, enc, cb) {
          testFiles.push(file.path)
          cb()
        },
        function (cb) {
          // At end-of-stream, push the list of files to the next step
          this.push(testFiles)
          cb()
        }
      )
    )
    .pipe(
      through.obj(function (testFiles, enc, cb) {
        browserify({
          entries: testFiles,
          cache: {},
          debug: true
        })
          .transform(babelifyTransform())
          .transform(browserifyTransformNodeToBrowserRequire())
          .bundle()
          .on('error', log.error)
          .pipe(source('neo4j-web.test.js'))
          .pipe(gulp.dest(browserOutput))
          .on('end', cb)
      })
    )
})

var buildNode = function (options) {
  return gulp
    .src(options.src)
    .pipe(babel(babelConfig()))
    .pipe(gulp.dest(options.dest))
}

gulp.task('nodejs', function () {
  return buildNode({
    src: 'src/**/*.js',
    dest: 'lib'
  })
})

// prepares directory for package.test.js
gulp.task(
  'install-driver-into-sandbox',
  gulp.series('nodejs', function () {
    var testDir = path.join('build', 'sandbox')
    fs.emptyDirSync(testDir)

    var packageJsonContent = JSON.stringify({
      private: true,
      dependencies: {
        'neo4j-driver': __dirname
      }
    })

    return file('package.json', packageJsonContent, { src: true })
      .pipe(gulp.dest(testDir))
      .pipe(install())
  })
)

gulp.task(
  'test-nodejs',
  gulp.series('install-driver-into-sandbox', function () {
    return gulp
      .src(['./test/**/*.test.js', '!./test/**/browser/*.js'])
      .pipe(
        jasmine({
          includeStackTrace: true,
          reporter: newJasmineConsoleReporter()
        })
      )
      .on('end', logActiveNodeHandles)
  })
)

gulp.task('run-browser-test-chrome', function (cb) {
  runKarma('chrome', cb)
})

gulp.task('run-browser-test-firefox', function (cb) {
  runKarma('firefox', cb)
})

gulp.task('run-browser-test-edge', function (cb) {
  runKarma('edge', cb)
})

gulp.task('run-browser-test-ie', function (cb) {
  runKarma('ie', cb)
})

gulp.task('run-browser-test', gulp.series('run-browser-test-firefox'))

gulp.task('watch', function () {
  return watch(
    'src/**/*.js',
    batch(function (events, done) {
      gulp.start('all', done)
    })
  )
})

gulp.task(
  'watch-n-test',
  gulp.series('test-nodejs', function () {
    return gulp.watch(['src/**/*.js', 'test/**/*.js'], ['test-nodejs'])
  })
)

/** Set the project version, controls package.json and version.js */
gulp.task('set', function () {
  // Get the --version arg from command line
  var version = minimist(process.argv.slice(2), { string: 'version' }).version

  if (!semver.valid(version)) {
    throw new Error(`Invalid version "${version}"`)
  }

  // Change the version in relevant files
  var versionFile = path.join('src', 'version.js')
  return gulp
    .src([versionFile], { base: './' })
    .pipe(replace('0.0.0-dev', version))
    .pipe(gulp.dest('./'))
})

var neo4jHome = path.resolve('./build/neo4j')

gulp.task('start-neo4j', function (done) {
  sharedNeo4j.start(neo4jHome, process.env.NEOCTRL_ARGS)
  done()
})

gulp.task('stop-neo4j', function (done) {
  sharedNeo4j.stop(neo4jHome)
  done()
})

gulp.task('run-stress-tests', function () {
  return gulp
    .src('test/**/stress.test.js')
    .pipe(
      jasmine({
        includeStackTrace: true,
        reporter: newJasmineConsoleReporter()
      })
    )
    .on('end', logActiveNodeHandles)
})

gulp.task('run-ts-declaration-tests', function () {
  var failed = false

  return gulp
    .src(['test/types/**/*', 'types/**/*'], { base: '.' })
    .pipe(
      ts({
        module: 'es6',
        target: 'es6',
        noImplicitAny: true,
        noImplicitReturns: true,
        strictNullChecks: true
      })
    )
    .on('error', function () {
      failed = true
    })
    .on('finish', function () {
      if (failed) {
        console.log(
          '[ERROR] TypeScript declarations contain errors. Exiting...'
        )
        process.exit(1)
      }
    })
    .pipe(gulp.dest('build/test/types'))
})

gulp.task('browser', gulp.series('build-browser-test', 'build-browser'))

gulp.task('all', gulp.series('nodejs', 'browser'))

gulp.task('test-browser', gulp.series('all', 'run-browser-test'))

gulp.task(
  'test',
  gulp.series('run-ts-declaration-tests', 'test-nodejs', 'test-browser')
)

gulp.task('default', gulp.series('test'))

function logActiveNodeHandles () {
  if (enableActiveNodeHandlesLogging) {
    console.log(
      '-- Active NodeJS handles START\n',
      process._getActiveHandles(),
      '\n-- Active NodeJS handles END'
    )
  }
}

function newJasmineConsoleReporter () {
  return new JasmineConsoleReporter({
    colors: 1,
    cleanStack: 1,
    verbosity: 4,
    listStyle: 'indent',
    activity: false
  })
}

function babelifyTransform () {
  return babelify.configure(babelConfig())
}

function babelConfig () {
  return {
    presets: [['@babel/preset-env']],
    plugins: ['@babel/plugin-transform-runtime']
  }
}

function browserifyTransformNodeToBrowserRequire () {
  var nodeRequire = '/node'
  var browserRequire = '/browser'

  return transformTools.makeRequireTransform(
    'bodeToBrowserRequireTransform',
    { evaluateArguments: true },
    function (args, opts, cb) {
      var requireArg = args[0]
      var endsWithNodeRequire =
        requireArg.slice(-nodeRequire.length) === nodeRequire
      if (endsWithNodeRequire) {
        var newRequireArg = requireArg.replace(nodeRequire, browserRequire)
        return cb(null, "require('" + newRequireArg + "')")
      } else {
        return cb()
      }
    }
  )
}

function runKarma (browser, cb) {
  new karma.Server(
    {
      configFile: path.join(__dirname, `/test/browser/karma-${browser}.conf.js`)
    },
    function (exitCode) {
      exitCode ? process.exit(exitCode) : cb()
    }
  ).start()
}
