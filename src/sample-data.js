/* 内置示例：samples/paper-grid-cases.zip 的 base64 副本。
 * 仅用于「载入内置示例」在无法读取本地文件（file:// 打开）时仍可运行。
 */
(function (root) {
  var SAMPLE_ZIP_BASE64 =
    'UEsDBBQAAAAIAJcJeV2GszFfqQAAAI8+AAAIAAAAc2Nhbi5wZ23t2bENwkAQRcHcKQ1QwhnpqIP++yAnxxF6tgxifjzB23gf' +
    'c1nv47qOsdzmXJ5mZn++y7ftve/o+6PX17y+5vU1r695fc3ra15f8/qa19e8vub1Na+veX3N62teX/P6mtfXvL7m9TV/9rtj' +
    's53vO9rra15f8/qa19e8vub1Na+veX3N62teX/P6mtfXvL7m9TWvr3l9zetrXl/z+po/+92x2Yf3mJmZ/dJeUEsDBBQAAAAI' +
    'AJcJeV3Jr4GyOQAAAI8+AAAIAAAAbWFzay5wZ23tzjENACEQADDmU4GE45NDB/7NQJheAkuroKtizOwjM76q2AAAAAAAAABw' +
    'td/rCgAAAAAAAADwxgFQSwMEFAAAAAgAlwl5XZBlH6osAAAAOQAAAAkAAABncmlkLmpzb26rVqooVrJSiLbQUTA101EwNDAB' +
    'EqZGsToKSpUwCRMgtrAACeXkJ2eDRWNrAVBLAwQUAAAICACXCXldvjEA4xoBAABgAQAACgAAAOagvOW8jy50eHRNkMFKw0AQ' +
    'hl9H0YMWAj6G95KDSKGiUDFQ09u2FRK1GpWkhdraJBQahcaAkW7TRB+mO7vJyVdw4vbgZfj3n29m+PdQYTQ5YNndmrT5iMB0' +
    'BiStKMqadHQNvZbGe9cFeQL/pfASSCwwB9yJuRNB1xKxC+MH7ho/aY+/W4xOGX0Tz7TorKSPGhZhbnxA9FjBlWIyz7+Wsgdj' +
    'g63u9/LQw+nm1kXjcve4cbYNo0DXqqhURm/yRdDSqthSwYyk2tlXka//5zeI5DfDyEuFPB4u7DaEw8JbwnzAw0/MfKSflPlw' +
    'ECtyWE9rtXPcXXbA6je52a/js3SRB9qFyMbP+YvxCpnPsm9hB2UGSAnMbsXwCiaJ8Ah3UxH7kDqI/gJQSwECFAMUAAAACACX' +
    'CXldhrMxX6kAAACPPgAACAAAAAAAAAAAAAAAgAEAAAAAc2Nhbi5wZ21QSwECFAMUAAAACACXCXldya+BsjkAAACPPgAACAAA' +
    'AAAAAAAAAAAAgAHPAAAAbWFzay5wZ21QSwECFAMUAAAACACXCXldkGUfqiwAAAA5AAAACQAAAAAAAAAAAAAAgAEuAQAAZ3Jp' +
    'ZC5qc29uUEsBAhQDFAAACAgAlwl5Xb4xAOMaAQAAYAEAAAoAAAAAAAAAAAAAAIABgQEAAOagvOW8jy50eHRQSwUGAAAAAAQA' +
    'BADbAAAAwwIAAAAA';

  var api = { SAMPLE_ZIP_BASE64: SAMPLE_ZIP_BASE64 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PaperGridSample = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
