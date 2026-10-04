import 'dart:async';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'core/api_client.dart';
import 'core/push_notifications.dart';
import 'models.dart';

enum SessionStatus { booting, signedOut, signedIn }

final class AppState extends ChangeNotifier {
  AppState(this.api,this.push){
    _pushActivity=push.activity.listen((_){
      if(sessionStatus==SessionStatus.signedIn&&!loading)unawaited(refreshOverview());
    });
  }
  final ApiClient api;
  final PushNotificationService push;
  late final StreamSubscription<void> _pushActivity;
  SessionStatus sessionStatus=SessionStatus.booting;
  bool loading=false;
  String? error;
  String? twoFactorChallenge;
  Organization? organization;
  List<Organization> organizations=const [];
  DashboardStats stats=const DashboardStats(total:0,online:0,offline:0,openAlerts:0);
  List<ServerSummary> servers=const [];
  List<AlertItem> alerts=const [];
  List<DeploymentItem> deployments=const [];
  List<NotificationItem> notifications=const [];

  bool get canOperate=>const {'owner','admin','operator'}.contains(organization?.role);
  int get unreadNotifications=>notifications.where((item)=>item.readAt==null).length;

  Future<void> bootstrap() async {
    try {
      if(!await api.restoreSession()){sessionStatus=SessionStatus.signedOut;return;}
      sessionStatus=SessionStatus.signedIn;
      await refreshOverview();
      unawaited(push.configureForSignedInUser());
    } on Object {sessionStatus=SessionStatus.signedOut;}
    finally {notifyListeners();}
  }

  Future<void> login(String email,String password) async {
    loading=true;error=null;notifyListeners();
    try {
      final challenge=await api.login(email:email,password:password,deviceName:'${Platform.operatingSystem} CloudDeck');
      if(challenge!=null){
        twoFactorChallenge=challenge;
        sessionStatus=SessionStatus.signedOut;
        return;
      }
      twoFactorChallenge=null;
      sessionStatus=SessionStatus.signedIn;
      await refreshOverview();
      unawaited(push.configureForSignedInUser());
    } on ApiException catch(exception) {error=exception.message;sessionStatus=SessionStatus.signedOut;}
    finally {loading=false;notifyListeners();}
  }

  Future<void> verifyTwoFactor(String code) async {
    final challenge=twoFactorChallenge;
    if(challenge==null)return;
    loading=true;error=null;notifyListeners();
    try{
      await api.completeTwoFactorLogin(challenge,code);
      twoFactorChallenge=null;
      sessionStatus=SessionStatus.signedIn;
      await refreshOverview();
      unawaited(push.configureForSignedInUser());
    } on ApiException catch(exception){
      error=exception.message;
      sessionStatus=SessionStatus.signedOut;
    } finally {loading=false;notifyListeners();}
  }

  void cancelTwoFactor(){
    twoFactorChallenge=null;
    error=null;
    notifyListeners();
  }

  Future<void> logout() async {
    loading=true;notifyListeners();
    try {
      try {await push.unregisterCurrentDevice();}
      finally {await api.logout();}
    } finally {
      sessionStatus=SessionStatus.signedOut;twoFactorChallenge=null;organization=null;organizations=const [];servers=const [];
      alerts=const [];deployments=const [];notifications=const [];loading=false;notifyListeners();
    }
  }

  Future<void> refreshOverview() async {
    loading=true;error=null;notifyListeners();
    try {
      final orgPayload=await api.get('/api/v1/organizations') as Map<String,dynamic>;
      organizations=(orgPayload['organizations'] as List<dynamic>).cast<Map<String,dynamic>>()
        .map(Organization.fromJson).toList(growable:false);
      organization??=organizations.firstOrNull;
      if(organization==null)throw ApiException('No CloudDeck workspace is available');
      if(!organizations.any((item)=>item.id==organization!.id))organization=organizations.first;
      await _loadWorkspace();
    } on ApiException catch(exception) {
      error=exception.message;if(exception.statusCode==401)sessionStatus=SessionStatus.signedOut;
    } finally {loading=false;notifyListeners();}
  }

  Future<void> selectOrganization(Organization next) async {organization=next;await _loadWorkspace();notifyListeners();}

  Future<void> _loadWorkspace() async {
    final org=organization!;
    final results=await Future.wait<dynamic>([
      api.get('/api/v1/organizations/${org.id}/dashboard'),
      api.get('/api/v1/organizations/${org.id}/servers'),
      api.get('/api/v1/organizations/${org.id}/alerts?state=open&limit=100'),
      api.get('/api/v1/organizations/${org.id}/deployments?limit=50'),
      api.get('/api/v1/notifications'),
    ]);
    stats=DashboardStats.fromJson(results[0] as Map<String,dynamic>);
    servers=((results[1] as Map<String,dynamic>)['servers'] as List<dynamic>).cast<Map<String,dynamic>>().map(ServerSummary.fromJson).toList(growable:false);
    alerts=((results[2] as Map<String,dynamic>)['alerts'] as List<dynamic>).cast<Map<String,dynamic>>().map(AlertItem.fromJson).toList(growable:false);
    deployments=((results[3] as Map<String,dynamic>)['deployments'] as List<dynamic>).cast<Map<String,dynamic>>().map(DeploymentItem.fromJson).toList(growable:false);
    notifications=((results[4] as Map<String,dynamic>)['notifications'] as List<dynamic>).cast<Map<String,dynamic>>().map(NotificationItem.fromJson).toList(growable:false);
  }

  Future<List<MetricPoint>> metrics(String serverId,{String range='24h'}) async {
    final payload=await api.get('/api/v1/servers/$serverId/metrics?range=$range') as Map<String,dynamic>;
    return (payload['points'] as List<dynamic>).cast<Map<String,dynamic>>().map(MetricPoint.fromJson).toList(growable:false);
  }

  Future<List<ContainerItem>> containers(String serverId) async {
    final payload=await api.get('/api/v1/servers/$serverId/docker/containers') as Map<String,dynamic>;
    return (payload['containers'] as List<dynamic>).cast<Map<String,dynamic>>().map(ContainerItem.fromJson).toList(growable:false);
  }

  Future<List<String>> containerLogs(String serverId,String containerId) async {
    final payload=await api.get('/api/v1/servers/$serverId/docker/containers/$containerId/logs?limit=200') as Map<String,dynamic>;
    return (payload['lines'] as List<dynamic>).cast<String>();
  }

  Future<void> restartContainer(String serverId,String containerId) async {
    await api.post('/api/v1/servers/$serverId/docker/containers/$containerId/action',body:{'action':'restart','confirm':true});
  }

  Future<void> acknowledgeAlert(String alertId) async {await api.post('/api/v1/alerts/$alertId/acknowledge');await refreshOverview();}
  Future<void> markNotificationRead(String notificationId) async {await api.post('/api/v1/notifications/$notificationId/read');await refreshOverview();}

  @override
  void dispose(){
    unawaited(_pushActivity.cancel());
    unawaited(push.dispose());
    api.close();
    super.dispose();
  }
}

extension<T> on List<T>{T? get firstOrNull=>isEmpty?null:first;}
