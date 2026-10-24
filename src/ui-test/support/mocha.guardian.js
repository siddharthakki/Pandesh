'use strict';

module.exports = {
  reporter: 'mocha-junit-reporter',
  reporterOptions: {
    mochaFile: process.env.GUARDIAN_JUNIT_PATH,
    suiteTitleSeparatedBy: ' / ',
    useFullSuiteTitle: true,
  },
  timeout: 720000,
  slow: 30000,
  color: true,
};
