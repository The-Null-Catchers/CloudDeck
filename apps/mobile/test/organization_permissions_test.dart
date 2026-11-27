import 'package:clouddeck_mobile/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main(){
  test('mobile demo and viewer workspaces never expose operational controls',(){
    for(final role in ['owner','admin','operator','viewer']){
      final demo=Organization.fromJson({'id':'demo','name':'Synthetic demo','role':role,'demo':true});
      expect(demo.canOperate,false,reason:'Demo $role must be read-only');
      final normal=Organization.fromJson({'id':'lab','name':'Disposable lab','role':role});
      expect(normal.canOperate,role!='viewer');
    }
  });
}
