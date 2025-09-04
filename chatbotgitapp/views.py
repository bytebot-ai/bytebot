from django.urls import reverse_lazy
from django.shortcuts import redirect, get_object_or_404
from django.views.generic import CreateView, UpdateView, DeleteView
from django.contrib.auth.forms import UserCreationForm, UserChangeForm
from django.contrib.auth.mixins import LoginRequiredMixin
from django.contrib.auth.views import LogoutView
from django.contrib.auth.views import LoginView
from .forms import MessageForm
from django.http import Http404
from .models import Message, User

# Create your views here.

class SignUpView(CreateView):
    form_class = UserCreationForm
    success_url = reverse_lazy('message')

    def dispatch(self, request, *args, **kwargs):
        if request.user.is_authenticated:
            return redirect('message')
        return super().dispatch(request, *args, **kwargs)

    def form_valid(self, form):
        response = super().form_valid(form)
        return response

class EditProfileView(LoginRequiredMixin, UpdateView):
    form_class = UserChangeForm
    success_url = reverse_lazy('message')

    def get_object(self):
        return self.request.user

    def form_valid(self, form):
        response = super().form_valid(form)
        return response

class DeleteAccountView(LoginRequiredMixin, DeleteView):
    success_url = reverse_lazy('login')

    def get_object(self, queryset=None):
        if self.request.user.is_authenticated:
            return self.request.user
        raise Http404("You are not logged in.")

    def form_valid(self, form):
        try:
            response = super().form_valid(form)
            return response
        except Exception as e:
            return redirect('delete_account')

class CustomLoginView(LoginView):
    redirect_authenticated_user = True

    def form_valid(self, form):
        remember_me = form.cleaned_data.get('remember_me')
        if remember_me:
            self.request.session.set_expiry(1209600 if remember_me else 0)  
        return super().form_valid(form)

    def get_success_url(self):
        return reverse_lazy('message')

class CustomLogoutView(LoginRequiredMixin, LogoutView):
    next_page = 'login'

class AddMessageView(LoginRequiredMixin, CreateView):
    form_class = MessageForm

def message_request_user_view(request):

    user = request.user
    review = Message.objects.filter(user=user)
#   return render(request, template_name, {'review': review})

def message_id_view(request, user_id):

    adresat = get_object_or_404(User, pk=user_id)
    user = request.user
    review = Message.objects.filter(user=user, to_user=adresat)
#   return render(request, template_name, {'review': review})