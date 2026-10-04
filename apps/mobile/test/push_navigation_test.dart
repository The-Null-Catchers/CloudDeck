import 'package:clouddeck_mobile/core/push_notifications.dart';
import 'package:flutter_test/flutter_test.dart';

void main(){
  test('push navigation preserves bounded backend route metadata',(){
    final intent=PushNavigationIntent.fromData({
      'type':'deployment',
      'href':'/organizations/org-1/deployments/deployment-1',
    });
    expect(intent.type,'deployment');
    expect(intent.href,'/organizations/org-1/deployments/deployment-1');
  });

  test('push navigation falls back safely when optional data is absent',(){
    final intent=PushNavigationIntent.fromData(const {});
    expect(intent.type,'info');
    expect(intent.href,isNull);
  });

  test('push navigation ignores non-string route values',(){
    final intent=PushNavigationIntent.fromData({'type':42,'href':true});
    expect(intent.type,'info');
    expect(intent.href,isNull);
  });
}
